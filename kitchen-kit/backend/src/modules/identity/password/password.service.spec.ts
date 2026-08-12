import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { UsersRepository } from '../users/users.repository';
import { AuditService } from '../../governance/audit/audit.service';
import { PasswordService } from './password.service';

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    email: 'user@example.com',
    status: 'active',
    ...overrides,
  };
}

describe('PasswordService', () => {
  let credentialFind: jest.Mock;
  let resetCreate: jest.Mock;
  let resetFind: jest.Mock;
  let txResetUpdate: jest.Mock;
  let txSessionUpdate: jest.Mock;
  let prisma: PrismaService;
  let users: { findById: jest.Mock; findByEmail: jest.Mock };
  let credentials: { verifyPasswordSafe: jest.Mock; rotatePassword: jest.Mock };
  let notifier: { notify: jest.Mock };
  let service: PasswordService;

  beforeEach(() => {
    credentialFind = jest.fn();
    resetCreate = jest.fn().mockResolvedValue(undefined);
    resetFind = jest.fn();
    txResetUpdate = jest.fn();
    txSessionUpdate = jest.fn().mockResolvedValue({ count: 0 });
    prisma = {
      credential: { findUnique: credentialFind },
      passwordResetToken: { create: resetCreate, findUnique: resetFind },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
        fn({
          passwordResetToken: { updateMany: txResetUpdate },
          session: { updateMany: txSessionUpdate },
        }),
      ),
    } as unknown as PrismaService;
    users = { findById: jest.fn(), findByEmail: jest.fn() };
    credentials = {
      verifyPasswordSafe: jest.fn(),
      rotatePassword: jest.fn().mockResolvedValue(undefined),
    };
    notifier = { notify: jest.fn() };
    const audit = { emit: jest.fn() } as unknown as AuditService;
    service = new PasswordService(
      prisma,
      users as unknown as UsersRepository,
      credentials as unknown as CredentialsService,
      audit,
      notifier,
    );
  });

  describe('changePassword', () => {
    it('rotates the credential and revokes other sessions on valid current password', async () => {
      users.findById.mockResolvedValue(activeUser());
      credentialFind.mockResolvedValue({ secretHash: 'hash' });
      credentials.verifyPasswordSafe.mockResolvedValue(true);

      await service.changePassword(
        'u-1',
        'sid-1',
        'old-pass',
        's3cure-passphrase',
      );

      expect(credentials.rotatePassword).toHaveBeenCalledWith(
        expect.anything(),
        'u-1',
        's3cure-passphrase',
      );
      const changeCalls = txSessionUpdate.mock.calls as Array<
        [{ where: unknown }]
      >;
      expect(changeCalls[0][0].where).toEqual({
        userId: 'u-1',
        id: { not: 'sid-1' },
        revokedAt: null,
      });
    });

    it('401s on a wrong current password (no rotation)', async () => {
      users.findById.mockResolvedValue(activeUser());
      credentialFind.mockResolvedValue({ secretHash: 'hash' });
      credentials.verifyPasswordSafe.mockResolvedValue(false);

      await expect(
        service.changePassword('u-1', 'sid-1', 'wrong', 's3cure-passphrase'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(credentials.rotatePassword).not.toHaveBeenCalled();
    });

    it('403s for a non-active account', async () => {
      users.findById.mockResolvedValue(activeUser({ status: 'disabled' }));
      await expect(
        service.changePassword('u-1', 'sid-1', 'old', 's3cure-passphrase'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('requestReset', () => {
    it('issues a token and notifies for an active account', async () => {
      users.findByEmail.mockResolvedValue(activeUser());
      await service.requestReset('User@Example.com');
      expect(resetCreate).toHaveBeenCalled();
      const notifyCalls = notifier.notify.mock.calls as Array<
        [{ token: string }]
      >;
      expect(typeof notifyCalls[0][0].token).toBe('string');
    });

    it('is a no-op (no token, no notify) for an unknown account', async () => {
      users.findByEmail.mockResolvedValue(null);
      await service.requestReset('nobody@example.com');
      expect(resetCreate).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('does not issue a token for a disabled account', async () => {
      users.findByEmail.mockResolvedValue(activeUser({ status: 'disabled' }));
      await service.requestReset('user@example.com');
      expect(resetCreate).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('consumes the token, rotates the credential, and revokes all sessions', async () => {
      resetFind.mockResolvedValue({ id: 'rt-1', userId: 'u-1' });
      txResetUpdate.mockResolvedValue({ count: 1 });

      await service.resetPassword('raw-token-value', 's3cure-passphrase');

      expect(txResetUpdate).toHaveBeenCalled();
      expect(credentials.rotatePassword).toHaveBeenCalledWith(
        expect.anything(),
        'u-1',
        's3cure-passphrase',
      );
      const resetCalls = txSessionUpdate.mock.calls as Array<
        [{ where: unknown }]
      >;
      expect(resetCalls[0][0].where).toEqual({
        userId: 'u-1',
        revokedAt: null,
      });
    });

    it('401s for an unknown token', async () => {
      resetFind.mockResolvedValue(null);
      await expect(
        service.resetPassword('missing', 's3cure-passphrase'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('401s on replay/expired (compare-and-swap consumes zero rows)', async () => {
      resetFind.mockResolvedValue({ id: 'rt-1', userId: 'u-1' });
      txResetUpdate.mockResolvedValue({ count: 0 });
      await expect(
        service.resetPassword('used', 's3cure-passphrase'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(credentials.rotatePassword).not.toHaveBeenCalled();
    });
  });
});
