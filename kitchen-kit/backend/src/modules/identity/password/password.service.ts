import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  SENTINEL_TENANT_ID,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { assertPasswordMeetsPolicy } from '../credentials/password-policy';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { generateResetToken, hashResetToken } from './password-reset-token';
import { PASSWORD_RESET_NOTIFIER } from './password-reset.notifier';
import type { PasswordResetNotifier } from './password-reset.notifier';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class PasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    @Inject(PASSWORD_RESET_NOTIFIER)
    private readonly notifier: PasswordResetNotifier,
  ) {}

  /**
   * Authenticated password change. Requires proof of the current password.
   * Rotates the credential and revokes all OTHER sessions (the current session
   * is kept) atomically.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== 'active') {
      throw new ForbiddenException('Account is not active.');
    }

    const credential = await this.prisma.credential.findUnique({
      where: {
        userId_credentialType: { userId, credentialType: 'password' },
      },
    });
    const ok = await this.credentials.verifyPasswordSafe(
      credential?.secretHash ?? null,
      currentPassword,
    );
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    assertPasswordMeetsPolicy(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await this.credentials.rotatePassword(tx, userId, newPassword);
      await tx.session.updateMany({
        where: { userId, id: { not: currentSessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.emit({
      tenantId: SENTINEL_TENANT_ID,
      action: AUDIT_ACTION.PASSWORD_CHANGED,
      entityType: AUDIT_ENTITY.USER,
      actorType: 'user',
      actorId: userId,
      entityId: userId,
      metadata: { otherSessionsRevoked: true },
    });
  }

  /**
   * Forgot-password request. Enumeration-safe: the externally observable result
   * is identical whether or not the account exists (or is active). A token is
   * only ever issued for an ACTIVE account.
   */
  async requestReset(email: string): Promise<void> {
    const normalized = UsersService.normalizeEmail(email);
    const user = await this.users.findByEmail(normalized);
    if (!user || user.status !== 'active') {
      return; // generic success; no token issued, nothing revealed
    }

    const token = generateResetToken();
    await this.prisma.passwordResetToken.create({
      data: {
        id: newId(),
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });
    await this.notifier.notify({ userId: user.id, email: normalized, token });

    await this.audit.emit({
      tenantId: SENTINEL_TENANT_ID,
      action: AUDIT_ACTION.PASSWORD_RESET_REQUESTED,
      entityType: AUDIT_ENTITY.USER,
      actorType: 'user',
      actorId: user.id,
      entityId: user.id,
      metadata: { result: 'issued' },
    });
  }

  /**
   * Complete a password reset. Single-use + expiry are enforced by an atomic
   * compare-and-swap consume; concurrent uses of the same token yield exactly
   * one success. On success the credential is rotated and ALL sessions revoked.
   * Invalid/expired/consumed/unknown tokens are a generic 401.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    assertPasswordMeetsPolicy(newPassword);

    const tokenHash = hashResetToken(token);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    if (!row) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count === 0) {
        // Already used, expired, or lost a concurrent race.
        throw new UnauthorizedException('Invalid or expired reset token');
      }
      await this.credentials.rotatePassword(tx, row.userId, newPassword);
      await tx.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.emit({
      tenantId: SENTINEL_TENANT_ID,
      action: AUDIT_ACTION.PASSWORD_RESET_COMPLETED,
      entityType: AUDIT_ENTITY.USER,
      actorType: 'user',
      actorId: row.userId,
      entityId: row.userId,
      metadata: { allSessionsRevoked: true },
    });
  }
}
