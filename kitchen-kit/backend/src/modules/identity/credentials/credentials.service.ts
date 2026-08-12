import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { assertPasswordMeetsPolicy } from './password-policy';

/**
 * Owns password authentication material. Passwords are only ever stored as
 * Argon2id hashes; plaintext is hashed here and never logged or returned.
 */
@Injectable()
export class CredentialsService {
  /** Hash a plaintext password with Argon2id. */
  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /** Constant-time-ish verify; returns false on any malformed/invalid hash. */
  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  private dummyHash?: Promise<string>;

  /**
   * Timing-equalised verify used by login. When there is no stored hash (unknown
   * account or no password credential) we still spend an Argon2id verification
   * against a throwaway hash, so login latency does not reveal whether the
   * account exists. Always returns false when {@link hash} is null.
   */
  async verifyPasswordSafe(
    hash: string | null,
    password: string,
  ): Promise<boolean> {
    this.dummyHash ??= this.hashPassword('timing-guard-placeholder-secret');
    const target = hash ?? (await this.dummyHash);
    const matches = await this.verifyPassword(target, password);
    return hash !== null && matches;
  }

  /**
   * Create the password credential for a freshly created user. Runs inside the
   * caller's transaction so a user can never exist without its credential.
   */
  async createPasswordCredential(
    tx: Prisma.TransactionClient,
    userId: string,
    password: string,
  ): Promise<void> {
    assertPasswordMeetsPolicy(password);
    const secretHash = await this.hashPassword(password);
    await tx.credential.create({
      data: {
        id: newId(),
        userId,
        credentialType: 'password',
        secretHash,
      },
    });
  }

  /**
   * Replace a user's password hash in place (rotation). Caller supplies the
   * transaction; session-invalidation policy is applied by the caller.
   */
  async rotatePassword(
    tx: Prisma.TransactionClient,
    userId: string,
    newPassword: string,
  ): Promise<void> {
    assertPasswordMeetsPolicy(newPassword);
    const secretHash = await this.hashPassword(newPassword);
    await tx.credential.update({
      where: {
        userId_credentialType: { userId, credentialType: 'password' },
      },
      data: { secretHash, mustReset: false, rotatedAt: new Date() },
    });
  }
}
